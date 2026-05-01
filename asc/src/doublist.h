//
// doublist.h
//
// Header of doublist.cc. Define the doubly linked list data type
// May be a template is more suitable. But currently it is not.
//
// Tien-Tsin Wong 1996
//
#ifndef __DOUBLIST_H
#define __DOUBLIST_H

#include "padi.h"

// Hold the padi or highrice in a doubly linked list
class DoublyList
{
  private:
    Padi *head, *last, *curr; // Since highrice are child or Padi, it can use this object also

  public:
    DoublyList(){head=last=curr=NULL;};
    ~DoublyList();
    Padi *First(){curr=head; return curr;};
    Padi *Next(){curr=curr->next; return curr;};
    Padi *Last(){curr=last; return curr;};
    Padi *Previous(){curr=curr->previous; return curr;};
    void Append(Padi *input);
    void Remove(Padi *input);
};


#endif
